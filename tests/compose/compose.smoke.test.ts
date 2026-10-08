/**
 * compose.smoke.test.ts — static smoke/lint checks for the ROOT docker-compose.yml.
 *
 * Design reference: "Docker Compose Topology" (walt.id VC e2e demo).
 * Validates Requirements 5.1, 5.2, 5.3, 5.5 (with light extra checks for 5.1 topology / 5.4).
 *
 * This test is intentionally dependency-free: the root package.json ships only
 * `vitest` and has NO YAML parser. Rather than add an npm-install-required
 * dependency, the compose file is read as UTF-8 text with node:fs/promises and
 * asserted with robust string/regex checks. The file is small and well-formed,
 * so text assertions are both sufficient and fast.
 *
 * Location: tests/compose/ keeps this non-network smoke test separate from the
 * live integration suite in tests/integration/. The root vitest.config.ts
 * `include` is broadened to 'tests/**\/*.test.ts' so this file is picked up.
 * Because of that, `npm run test:integration` (vitest run) also runs this smoke
 * test — which is fine and desirable: it needs no running stack.
 */

import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';

// tests/compose/ is two levels below the repo root.
const composeUrl = new URL('../../docker-compose.yml', import.meta.url);

let compose: string;

beforeAll(async () => {
  compose = await readFile(composeUrl, 'utf8');
});

describe('docker-compose.yml static smoke checks', () => {
  // Req 5.1: the three services are defined as separate services.
  it('defines issuer, verifier, and wallet services', () => {
    expect(compose).toMatch(/^\s{2}issuer:\s*$/m);
    expect(compose).toMatch(/^\s{2}verifier:\s*$/m);
    expect(compose).toMatch(/^\s{2}wallet:\s*$/m);
  });

  // Req 5.1 (topology): the shared bridge network name is present.
  it('declares the cdpi-net network', () => {
    expect(compose).toContain('name: cdpi-net');
  });

  // Req 5.2: walt.id images are pinned to an explicit version tag (not latest/floating).
  it('pins walt.id images to explicit version tags', () => {
    expect(compose).toContain('image: waltid/issuer-api2:1.1.1');
    expect(compose).toContain('image: waltid/verifier-api2:1.1.1');

    // No floating/`latest` tag anywhere in the file.
    expect(compose).not.toContain(':latest');

    // Every walt.id image ref carries an explicit, non-`latest` version tag.
    const waltidImages = compose.match(/image:\s*waltid\/[^\s:]+:(\S+)/g) ?? [];
    expect(waltidImages.length).toBeGreaterThanOrEqual(2);
    for (const ref of waltidImages) {
      const tag = ref.split(':').pop();
      expect(tag).toBeDefined();
      expect(tag).not.toBe('latest');
      // Looks like a version (e.g. 1.1.1), not an empty/floating tag.
      expect(tag).toMatch(/^\d+(\.\d+)*$/);
    }
  });

  // Req 5.3: each service has a memory limit within the 512MB–1GB band.
  it('sets memory limits within the 512MB-1GB band for all three services', () => {
    const limits = (compose.match(/mem_limit:\s*(\S+)/g) ?? []).map((m) =>
      m.replace(/mem_limit:\s*/, '').trim(),
    );

    // Exactly three services, each with a mem_limit.
    expect(limits).toHaveLength(3);

    // JVM services at 1g, wallet at 512m.
    expect(compose).toMatch(/image: waltid\/issuer-api2:1\.1\.1[\s\S]*?mem_limit:\s*1g/);
    expect(compose).toMatch(/image: waltid\/verifier-api2:1\.1\.1[\s\S]*?mem_limit:\s*1g/);
    expect(compose).toMatch(/build:\s*\.\/services\/wallet[\s\S]*?mem_limit:\s*512m/);

    // Every value is inside the band {512m, 1g}; reject out-of-band values (e.g. 256m, 2g).
    const allowed = new Set(['512m', '1g']);
    for (const value of limits) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  // Req 5.5: HTTP interfaces are mapped to host ports.
  it('maps the required host ports', () => {
    expect(compose).toContain('3000:3000');
    expect(compose).toContain('7004:7004');
    expect(compose).toContain('7005:7005');
  });

  // Req 5.4 (light extra check): wallet depends on issuer and verifier.
  it('declares wallet depends_on issuer and verifier', () => {
    const dependsOn = compose.slice(compose.indexOf('depends_on:'));
    expect(dependsOn).toContain('issuer:');
    expect(dependsOn).toContain('verifier:');
    expect(dependsOn).toContain('service_healthy');
  });
});
