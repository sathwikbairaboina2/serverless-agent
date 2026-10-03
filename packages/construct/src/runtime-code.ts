import { existsSync } from 'node:fs';
import * as path from 'node:path';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/** Directory of the prebundled runtime (ADR 0008). Same path from src/ (tests) and lib/ (published). */
export const RUNTIME_ASSET_DIR = path.join(__dirname, '..', 'assets', 'runtime');

export function runtimeCode(): lambda.Code {
  if (!existsSync(path.join(RUNTIME_ASSET_DIR, 'index.mjs'))) {
    throw new Error(`ServerlessAgent runtime bundle not found in ${RUNTIME_ASSET_DIR}. Run "pnpm --filter @serverless-agent/construct run bundle" first.`);
  }
  return lambda.Code.fromAsset(RUNTIME_ASSET_DIR);
}
