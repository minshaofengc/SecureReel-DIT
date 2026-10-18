// SPDX-License-Identifier: GPL-3.0-only
import { z } from 'zod';
export interface ProjectDetails {
  projectName: string;
  shootDay: string;
  camera: string;
  lenses: { model: string; detail: string }[];
  notes: string;
  crew: { role: string; name: string }[];
}
export interface TaskProject extends ProjectDetails {
  cardLabel: string;
  copyNotes: string;
  parentProjectName?: string | null;
}
const bounded = (max: number) =>
  z
    .string()
    .max(max)
    .refine(v => ![...v].some(c => (c.codePointAt(0) ?? 0) < 32));
const short = bounded(120);
const note = z
  .string()
  .max(4000)
  .refine(
    v =>
      ![...v].some(c => {
        const n = c.codePointAt(0) ?? 0;
        return n < 32 && ![9, 10, 13].includes(n);
      }),
  );
export const detailsSchema = z.object({
  projectName: bounded(160),
  shootDay: bounded(40),
  camera: short,
  lenses: z.array(z.object({ model: short, detail: short })).max(40),
  notes: note,
  crew: z.array(z.object({ role: short.max(80), name: short.max(80) })).max(50),
});
export const readDetailsSchema = z.object({
  projectName: z.string().max(160),
  shootDay: z.string().max(8192),
  camera: z.string().max(8192),
  lenses: z
    .array(
      z.object({ model: z.string().max(120), detail: z.string().max(120) }),
    )
    .max(40),
  notes: z.string().max(8192),
  crew: z
    .array(z.object({ role: z.string().max(80), name: z.string().max(80) }))
    .max(50),
});
export const readTaskProjectSchema = readDetailsSchema.extend({
  cardLabel: z.string().max(120),
  copyNotes: z.string().max(8192),
  parentProjectName: z.string().max(120).nullable().optional(),
});
export const taskProjectSchema = detailsSchema.extend({
  cardLabel: short,
  copyNotes: note,
  parentProjectName: short.nullable().optional(),
});
export const emptyDetails = (): ProjectDetails => ({
  projectName: '',
  shootDay: '',
  camera: '',
  lenses: [],
  notes: '',
  crew: [],
});
export function validateProjectDetails(value: unknown): ProjectDetails {
  return detailsSchema.parse(value);
}
export function normalizeProject(input: unknown) {
  const base = z
    .object({
      id: z.string().min(1).max(256),
      name: z.string().max(120),
      details: z.unknown().optional(),
      camera: z.string().max(8192).optional(),
      notes: z.string().max(8192).optional(),
      shootDay: z.string().max(8192).optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().nullable().optional(),
    })
    .parse(input);
  const details = readDetailsSchema.parse({
    ...emptyDetails(),
    projectName: base.name,
    camera: base.camera ?? '',
    notes: base.notes ?? '',
    shootDay: base.shootDay ?? '',
    ...(base.details && typeof base.details === 'object' ? base.details : {}),
  });
  return {
    id: base.id,
    name: base.name,
    details,
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
  };
}
export interface Settings {
  themeMode: 'system' | 'light' | 'dark';
  hashAlgorithm:
    | 'xxhash64'
    | 'xxh3'
    | 'xxh128'
    | 'md5'
    | 'sha1'
    | 'sha256'
    | 'asc-c4';
  manifestFormat: 'asc-mhl-2.0' | 'mhl-v1' | 'csv' | 'json';
  keepScreenOn: boolean;
  onboardingDone: boolean;
}
export const defaultSettings: Settings = {
  themeMode: 'system',
  hashAlgorithm: 'xxhash64',
  manifestFormat: 'asc-mhl-2.0',
  keepScreenOn: false,
  onboardingDone: false,
};
export function normalizeSettings(input: unknown): Settings {
  const value = z
    .object({
      themeMode: z.enum(['system', 'light', 'dark']).catch('system'),
      hashAlgorithm: z
        .enum(['xxhash64', 'xxh3', 'xxh128', 'md5', 'sha1', 'sha256', 'asc-c4'])
        .catch('xxhash64'),
      manifestFormat: z
        .enum(['asc-mhl-2.0', 'mhl-v1', 'csv', 'json'])
        .catch('asc-mhl-2.0'),
      keepScreenOn: z.boolean().catch(false),
      onboardingDone: z.boolean().catch(false),
    })
    .parse({
      ...defaultSettings,
      ...(input && typeof input === 'object' ? input : {}),
    });
  if (
    (value.manifestFormat === 'asc-mhl-2.0' &&
      value.hashAlgorithm === 'sha256') ||
    (value.manifestFormat === 'mhl-v1' &&
      !['xxhash64', 'md5', 'asc-c4'].includes(value.hashAlgorithm))
  )
    value.manifestFormat = 'json';
  return value;
}
