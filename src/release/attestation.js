import fs from 'fs-extra';
import path from 'path';
import {
  sha256File,
  createSLSAProvenance,
  generateDSSEStatement,
  buildAttestationBundle,
  createArtifactSubject,
  createSigstoreKeylessProof,
  verifyAttestationSignature
} from './sigstore.js';

const PREDICATE_BUILD = 'https://slsa.dev/provenance/v1';
const PREDICATE_GITHUB = 'https://github.com/Attestations/GitHubHostedActions@v1';

function detectCI() {
  if (process.env.GITHUB_ACTIONS) return 'github';
  if (process.env.GITLAB_CI) return 'gitlab';
  if (process.env.JENKINS_URL) return 'jenkins';
  return 'local';
}

function getGitHubContext() {
  return {
    ci: 'github',
    workflow: process.env.GITHUB_WORKFLOW || '',
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
    job: process.env.GITHUB_JOB || '',
    actor: process.env.GITHUB_ACTOR || '',
    repository: process.env.GITHUB_REPOSITORY || '',
    ref: process.env.GITHUB_REF || '',
    sha: process.env.GITHUB_SHA || '',
    token: process.env.GITHUB_TOKEN || '',
    attestationsUrl: process.env.ATTESTATIONS_URL || ''
  };
}

export function getBuildEnvironment() {
  const ci = detectCI();
  return {
    ci,
    ...(ci === 'github' ? getGitHubContext() : { os: process.platform, arch: process.arch })
  };
}

export async function generateBuildAttestation(artifactPath, options = {}) {
  const env = getBuildEnvironment();
  const artifactHash = await sha256File(artifactPath);
  const artifactName = options.name || path.basename(artifactPath);
  const subject = createArtifactSubject(artifactName, artifactHash);

  const buildStartedOn = options.buildStartedOn || new Date(Date.now() - 60000).toISOString();
  const buildFinishedOn = options.buildFinishedOn || new Date().toISOString();

  const materials = (options.materials || []).map(m => ({
    uri: m.uri || '',
    digest: { sha256: m.hash || m.sha256 || '' }
  }));

  if (env.ci === 'github' && env.sha) {
    materials.unshift({
      uri: `git+https://github.com/${env.repository}@${env.ref}`,
      digest: { sha256: env.sha }
    });
  }

  const provenance = createSLSAProvenance({
    builderId: options.builderId || (env.ci === 'github'
      ? `https://github.com/${env.repository}/Actions/${env.workflow}@${env.ref}`
      : `https://localhost/builds/${process.pid}`),
    builderVersion: options.builderVersion || 'v1',
    invocation: {
      id: options.invocationId || (env.ci === 'github' ? env.runId : String(process.pid)),
      externalParameters: {
        platform: options.platform || `${process.platform}-${process.arch}`,
        environment: env
      }
    },
    materials,
    artifacts: [subject],
    buildStartedOn,
    buildFinishedOn
  });

  const statement = generateDSSEStatement(subject, PREDICATE_BUILD, provenance);

  let signingMaterial = options.signingMaterial || {};
  if (!signingMaterial.signature) {
    signingMaterial = {
      ...createSigstoreKeylessProof({
        issuer: 'https://token.actions.githubusercontent.com',
        subject: env.repository ? `repo:${env.repository}:ref:${env.ref}` : `local:${process.platform}`,
        repository: env.repository || '',
        workflow: env.workflow || '',
        ref: env.ref || 'refs/heads/main',
        sha: env.sha || '',
        logIndex: Number(process.env.GITHUB_RUN_ID || 0)
      })
    };
  }

  const bundle = buildAttestationBundle(statement, signingMaterial);

  return {
    environment: env,
    artifact: { name: artifactName, sha256: artifactHash, path: artifactPath },
    provenance,
    statement,
    bundle
  };
}

export async function writeCIAttestationFiles(artifactPath, attestation, outDir) {
  await fs.ensureDir(outDir);

  const baseName = path.basename(artifactPath);
  const bundlePath = path.join(outDir, `${baseName}.intoto.sigstore.json`);
  const statementPath = path.join(outDir, `${baseName}.statement.json`);
  const provenancePath = path.join(outDir, `${baseName}.provenance.json`);
  const envPath = path.join(outDir, `${baseName}.build-env.json`);

  await fs.writeJson(bundlePath, attestation.bundle, { spaces: 2 });
  await fs.writeJson(statementPath, attestation.statement, { spaces: 2 });
  await fs.writeJson(provenancePath, attestation.provenance, { spaces: 2 });
  await fs.writeJson(envPath, attestation.environment, { spaces: 2 });

  return { bundlePath, statementPath, provenancePath, envPath };
}

export async function generateChecksumsFile(artifacts, outDir) {
  const lines = [];
  for (const artifact of artifacts) {
    const hash = artifact.sha256 || await sha256File(artifact.path);
    lines.push(`${hash}  ${artifact.name}`);
  }
  const checksumFile = path.join(outDir, 'SHA256SUMS');
  await fs.writeFile(checksumFile, lines.join('\n') + '\n');
  return checksumFile;
}

export async function verifyArtifactAttestation(artifactPath, bundlePath) {
  const artifactHash = await sha256File(artifactPath);
  const bundle = await fs.readJson(bundlePath);
  const result = await verifyAttestationSignature(bundle, { sha256: artifactHash });
  return result;
}

export function getGitHubActionsAttestationOutput(attestations) {
  const lines = [];
  lines.push('echo "=== Build Provenance ==="');

  for (const att of attestations) {
    lines.push(`artifact=${att.artifact.name}`);
    lines.push(`sha256=${att.artifact.sha256}`);
    lines.push(`builder=${att.provenance.runDetails.builder.id}`);
  }

  return lines.join('\n');
}

export { PREDICATE_BUILD, PREDICATE_GITHUB };
