import type { CustomQuery, RepoLabel, SearchPreview } from './github.ts';

export type ToEditor =
  | { type: 'settings'; filters: CustomQuery[]; repos: string[] }
  | { type: 'select'; name: string }
  | { type: 'create' }
  | { type: 'labels'; repo: string; labels: RepoLabel[]; error?: string }
  | { type: 'preview'; seq: number; result: SearchPreview }
  | { type: 'previewError'; seq: number; message: string }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string };

export type FromEditor =
  | { type: 'ready' }
  | { type: 'save'; filters: CustomQuery[] }
  | { type: 'revert' }
  | { type: 'labels'; repo: string }
  | { type: 'preview'; seq: number; query: string }
  | { type: 'open'; url: string };
