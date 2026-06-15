const VALID_CHANNELS = ['stable', 'beta', 'nightly'];

export function isValidChannel(channel) {
  return VALID_CHANNELS.includes(channel);
}

export function assertValidChannel(channel) {
  if (!isValidChannel(channel)) {
    throw new Error(`无效的发布 channel: ${channel}，必须是: ${VALID_CHANNELS.join(', ')}`);
  }
}

export function getChannelFromVersion(version) {
  const match = /-(beta|nightly)/.exec(version);
  if (match) return match[1];
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'stable';
  return 'beta';
}

export function formatVersionForChannel(version, channel) {
  assertValidChannel(channel);
  const base = version.replace(/-(beta|nightly)\.?\d*$/, '');
  if (channel === 'stable') {
    if (!/^\d+\.\d+\.\d+$/.test(base)) {
      throw new Error(`无法从 ${base} 生成稳定版号`);
    }
    return base;
  }
  const ts = Date.now();
  return `${base}-${channel}.${ts}`;
}

export function getChannelMetadata(channel, version, options = {}) {
  assertValidChannel(channel);
  return {
    channel,
    version,
    publishedAt: new Date().toISOString(),
    minimumRequiredCliVersion: options.minimumRequiredCliVersion || '1.0.0',
    releaseNotes: options.releaseNotes || '',
    breakingChanges: options.breakingChanges || false,
    deprecated: options.deprecated || false,
    checksums: {},
    attestations: {},
    signatures: {}
  };
}

export function compareChannelPriority(a, b) {
  const priority = { stable: 3, beta: 2, nightly: 1 };
  return (priority[b] || 0) - (priority[a] || 0);
}

export function buildReleaseManifest(builds, options = {}) {
  const {
    channel = getChannelFromVersion(options.version || '0.0.0'),
    version = '1.0.0',
    repo = '',
    commit = '',
    buildDate = new Date().toISOString()
  } = options;

  assertValidChannel(channel);

  const manifest = {
    schemaVersion: '1.0.0',
    version,
    channel,
    publishedAt: buildDate,
    git: {
      repository: repo,
      commit
    },
    supportedChannels: VALID_CHANNELS,
    platforms: {},
    checksums: {},
    attestations: {}
  };

  for (const build of builds) {
    if (!build.platform) continue;
    manifest.platforms[build.platform] = {
      file: build.file,
      compressed: build.compressed,
      size: build.size,
      compressedSize: build.compressedSize,
      sha256: build.sha256 || '',
      sigstore: build.sigstore || {}
    };
    if (build.sha256) {
      manifest.checksums[build.platform] = {
        sha256: build.sha256,
        sha512: build.sha512 || ''
      };
    }
    if (build.attestation) {
      manifest.attestations[build.platform] = {
        provenance: build.attestation.provenance,
        bundle: build.attestation.bundle,
        verified: build.attestation.verified || false
      };
    }
  }

  return manifest;
}

export function filterBuildsByChannel(manifests, channel) {
  assertValidChannel(channel);
  return manifests.filter(m => m.channel === channel)
    .sort((a, b) => compareChannelPriority(a.channel, b.channel) || new Date(b.publishedAt) - new Date(a.publishedAt));
}

export function getLatestForChannel(manifests, channel) {
  const filtered = filterBuildsByChannel(manifests, channel);
  return filtered[0] || null;
}

export { VALID_CHANNELS };
