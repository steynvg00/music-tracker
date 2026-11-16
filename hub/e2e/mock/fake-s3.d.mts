import type { Server } from 'node:http';
export interface FakeS3 {
	control: { failPart: number; hideEtag: boolean; clockSkewS: number; log: string[] };
	objects: Map<string, { body: Buffer; type: string; etag: string }>;
	uploads: Map<string, { key: string; type: string; parts: Map<number, { body: Buffer; etag: string }> }>;
	listen(port: number, host?: string): Promise<Server>;
}
export function createFakeS3(o?: { accessKeyId?: string; secretAccessKey?: string; region?: string; bucket?: string; prefix?: string }): FakeS3;
