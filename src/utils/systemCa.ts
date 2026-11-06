import tls from 'node:tls';

/**
 * Trust the OS certificate store in addition to Node's bundled CAs, like browsers do.
 * Needed behind TLS-inspecting corporate proxies, whose root CA is only installed in the OS.
 */
export function trustSystemCertificates(): boolean {
  if (typeof tls.setDefaultCACertificates !== 'function') return false;
  const merged = new Set([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  tls.setDefaultCACertificates([...merged]);
  return true;
}
