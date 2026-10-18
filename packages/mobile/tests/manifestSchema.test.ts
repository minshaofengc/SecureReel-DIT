import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { reportBundle, type HashAlgorithm, type Job } from '../src/domain';
const python = process.env.SECUREREEL_XSD_PYTHON;
const vectors: [HashAlgorithm, string][] = [
  ['xxhash64', 'ef46db3751d8e999'],
  ['xxh3', '2d06800538d394c2'],
  ['xxh128', '99aa06d3014798d86001c324468d497f'],
  ['md5', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['sha1', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
  [
    'asc-c4',
    'c459dsjfscH38cYeXXYogktxf4Cd9ibshE3BHUo6a58hBXmRQdZrAkZzsWcbWtDg5oQstpDuni4Hirj75GEmTc1sFT',
  ],
];
it.skipIf(!python)(
  'mobile ASC manifests for all supported algorithms and empty results validate against the official schema',
  () => {
    const folder = mkdtempSync(join(tmpdir(), 'securereel-mobile-xsd-'));
    try {
      const job: Job = {
        id: 'job_test',
        name: '卡 A001',
        mode: 'verify',
        state: 'completed',
        totalFiles: 1,
        totalBytes: 0,
        filesDone: 1,
        filesFailed: 0,
        bytesDone: 0,
        sourceRootId: 'source',
        targetRootIds: ['target'],
        manifestFormat: 'asc-mhl-2.0',
      };
      for (const [algorithm, hash] of [
        ...vectors,
        ['xxhash64', ''] as [HashAlgorithm, string],
      ]) {
        const bundle = reportBundle({
          ...job,
          hashAlgorithm: algorithm,
          files: hash
            ? [
                {
                  relativePath: '镜头 & 空白.mov',
                  bytes: 0,
                  sourceHash: hash,
                  targets: [
                    { rootId: 'target', status: 'verified', hash, bytes: 0 },
                  ],
                },
              ]
            : [],
        });
        const path = join(folder, 'manifest.mhl');
        writeFileSync(path, bundle.manifest);
        const result = execFileSync(
          python!,
          [
            '-c',
            'import sys; from lxml import etree; schema=etree.XMLSchema(etree.parse(sys.argv[1])); schema.assertValid(etree.parse(sys.argv[2])); print("VALID")',
            resolve(__dirname, '../../../tests/fixtures/ASCMHL.xsd'),
            path,
          ],
          { encoding: 'utf8', timeout: 15000 },
        );
        expect(result.trim()).toBe('VALID');
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
);
