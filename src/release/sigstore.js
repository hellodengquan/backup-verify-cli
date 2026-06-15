import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';

const PREDICATE_VCS = 'https://slsa.dev/provenance/v1';
const BUNDLE_MEDIA_TYPE = 'application/vnd.dev.sigstore.bundle+json;version=0.3';

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function generateDSSEStatement(subject, predicateType, predicate) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: Array.isArray(subject) ? subject : [subject],
    predicateType,
    predicate
  };
}

export function createSLSAProvenance(options) {
  const {
    builderId = 'https://github.com/backup-verify-cli/Attestations',
    builderVersion = 'v1.0.0',
    buildType = 'https://github.com/backup-verify-cli/BuildType',
    invocation = {},
    materials = [],
    artifacts = [],
    buildStartedOn = new Date().toISOString(),
    buildFinishedOn = new Date().toISOString()
  } = options;

  return {
    buildDefinition: {
      buildType,
      externalParameters: invocation.externalParameters || {},
      internalParameters: invocation.internalParameters || {},
      resolvedDependencies: materials.map(m => ({
        uri: m.uri || '',
        digest: m.digest || { sha256: m.hash || '' }
      }))
    },
    runDetails: {
      builder: {
        id: builderId,
        version: builderVersion
      },
      metadata: {
        invocationId: invocation.id || crypto.randomBytes(16).toString('hex'),
        startedOn: buildStartedOn,
        finishedOn: buildFinishedOn
      }
    },
    subject: artifacts.map(a => ({
      name: a.name,
      digest: a.digest || { sha256: a.hash || '' }
    }))
  };
}

export function createArtifactSubject(name, hash, algorithm = 'sha256') {
  return {
    name,
    digest: { [algorithm]: hash }
  };
}

export function buildAttestationBundle(statement, signingMaterial = {}) {
  const payload = Buffer.from(JSON.stringify(statement)).toString('base64');

  const signature = signingMaterial.signature
    || crypto.createHash('sha256').update(payload).digest('base64');

  return {
    mediaType: BUNDLE_MEDIA_TYPE,
    verificationMaterial: signingMaterial.verificationMaterial || {
      content: {
        $case: 'x509CertificateChain',
        x509CertificateChain: {
          certificates: signingMaterial.certificates || []
        }
      },
      tlogEntries: signingMaterial.tlogEntries || []
    },
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload,
      signatures: [
        {
          keyId: signingMaterial.keyId || '',
          sig: signature
        }
      ]
    }
  };
}

export async function signArtifact(filePath, options = {}) {
  const hash = await sha256File(filePath);
  const name = options.name || path.basename(filePath);

  const subject = createArtifactSubject(name, hash);

  const slsa = createSLSAProvenance({
    builderId: options.builderId,
    builderVersion: options.builderVersion,
    buildType: options.buildType,
    invocation: options.invocation,
    materials: options.materials,
    artifacts: [subject],
    buildStartedOn: options.buildStartedOn,
    buildFinishedOn: options.buildFinishedOn
  });

  const statement = generateDSSEStatement(subject, PREDICATE_VCS, slsa);
  const bundle = buildAttestationBundle(statement, options.signingMaterial || {});

  return {
    name,
    hash: { algorithm: 'sha256', value: hash },
    statement,
    bundle
  };
}

export async function writeAttestation(artifactPath, attestation, outDir) {
  const attestationPath = path.join(outDir, `${path.basename(artifactPath)}.sigstore.json`);
  await fs.writeJson(attestationPath, attestation.bundle, { spaces: 2 });

  const provenancePath = path.join(outDir, `${path.basename(artifactPath)}.provenance.json`);
  await fs.writeJson(provenancePath, attestation.statement, { spaces: 2 });

  return { attestationPath, provenancePath };
}

export async function verifyAttestationSignature(attestationBundle, expectedDigest = null) {
  if (!attestationBundle) return { valid: false, error: '无 attestation' };
  if (!attestationBundle.dsseEnvelope) return { valid: false, error: '缺少 dsseEnvelope' };

  const { payload, signatures } = attestationBundle.dsseEnvelope;
  if (!signatures || signatures.length === 0) {
    return { valid: false, error: '缺少签名' };
  }

  if (expectedDigest) {
    try {
      const payloadJson = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
      for (const subj of payloadJson.subject || []) {
        const alg = Object.keys(expectedDigest)[0];
        if (subj.digest && subj.digest[alg] === expectedDigest[alg]) {
          return { valid: true, subject: subj };
        }
      }
      return { valid: false, error: 'subject 摘要不匹配' };
    } catch (e) {
      return { valid: false, error: `payload 解析失败: ${e.message}` };
    }
  }

  return { valid: true };
}

export function createSigstoreKeylessProof(options = {}) {
  return {
    signature: crypto.createHash('sha256').update(options.message || 'sigstore-keyless').digest('hex'),
    verificationMaterial: {
      oidcClaims: {
        iss: options.issuer || 'https://token.actions.githubusercontent.com',
        sub: options.subject || '',
        aud: options.audience || 'sigstore',
        repository: options.repository || '',
        workflow: options.workflow || '',
        ref: options.ref || 'refs/heads/main',
        sha: options.sha || ''
      },
      tlogEntries: [
        {
          logIndex: options.logIndex || 0,
          logId: options.logId || '',
          kindVersion: { kind: 'hashedrekord', version: '0.0.1' }
        }
      ]
    }
  };
}
