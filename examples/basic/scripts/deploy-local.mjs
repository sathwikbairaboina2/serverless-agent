import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  CloudFormationClient, CreateStackCommand, DescribeStackEventsCommand, DescribeStacksCommand, UpdateStackCommand,
  waitUntilStackCreateComplete, waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';

const STACK = 'ServerlessAgentLocal';
const here = path.dirname(fileURLToPath(import.meta.url));
const cdkOut = path.resolve(here, '..', 'cdk.out');
const endpoint = process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
const common = { endpoint, region: process.env.AWS_REGION ?? 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
const s3 = new S3Client({ ...common, forcePathStyle: true });
const cfn = new CloudFormationClient(common);

function zipDirectory(dir) {
  const files = {};
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files[rel] = [readFileSync(full), { mtime: new Date('2026-01-01T00:00:00Z') }];
    }
  };
  walk(dir, '');
  return zipSync(files, { level: 6 });
}

async function ensureBucket(Bucket) {
  try { await s3.send(new CreateBucketCommand({ Bucket })); }
  catch (err) { if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(err.name)) throw err; }
}

async function publishAssets() {
  const manifest = JSON.parse(readFileSync(path.join(cdkOut, `${STACK}.assets.json`), 'utf8'));
  let templateUrl;
  for (const [hash, asset] of Object.entries(manifest.files ?? {})) {
    const src = path.join(cdkOut, asset.source.path);
    const body = asset.source.packaging === 'zip' || statSync(src).isDirectory() ? zipDirectory(src) : readFileSync(src);
    for (const dest of Object.values(asset.destinations)) {
      await ensureBucket(dest.bucketName);
      await s3.send(new PutObjectCommand({ Bucket: dest.bucketName, Key: dest.objectKey, Body: body }));
      console.log(`uploaded ${asset.source.path} -> s3://${dest.bucketName}/${dest.objectKey} (${body.length} bytes)`);
      if (asset.source.path === `${STACK}.template.json`) templateUrl = `${endpoint}/${dest.bucketName}/${dest.objectKey}`;
    }
    void hash;
  }
  if (Object.keys(manifest.dockerImages ?? {}).length > 0) throw new Error('Docker image assets need ECR, which LocalStack Hobby does not include (ADR 0009).');
  return templateUrl;
}

async function stackExists() {
  try { const out = await cfn.send(new DescribeStacksCommand({ StackName: STACK })); return out.Stacks?.[0]?.StackStatus !== 'DELETE_COMPLETE'; }
  catch (err) { if (String(err.message).includes('does not exist')) return false; throw err; }
}

async function printFailures() {
  const out = await cfn.send(new DescribeStackEventsCommand({ StackName: STACK }));
  for (const e of (out.StackEvents ?? []).filter((x) => String(x.ResourceStatus).endsWith('FAILED')).slice(0, 20)) {
    console.error(`${e.LogicalResourceId} ${e.ResourceType} ${e.ResourceStatus}: ${e.ResourceStatusReason}`);
  }
}

const templateUrl = await publishAssets();
const templateBody = readFileSync(path.join(cdkOut, `${STACK}.template.json`), 'utf8');
const source = Buffer.byteLength(templateBody) <= 51_200 ? { TemplateBody: templateBody } : { TemplateURL: templateUrl };
if (!source.TemplateBody && !source.TemplateURL) throw new Error('Template exceeds 51,200 bytes and was not uploaded as an asset.');
const params = { StackName: STACK, Capabilities: ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'], ...source };

try {
  if (await stackExists()) {
    try {
      await cfn.send(new UpdateStackCommand(params));
      await waitUntilStackUpdateComplete({ client: cfn, maxWaitTime: 600 }, { StackName: STACK });
    } catch (err) {
      if (!String(err.message).includes('No updates are to be performed')) throw err;
      console.log('stack unchanged');
    }
  } else {
    await cfn.send(new CreateStackCommand(params));
    await waitUntilStackCreateComplete({ client: cfn, maxWaitTime: 600 }, { StackName: STACK });
  }
} catch (err) {
  console.error(`deploy failed: ${err.message}`);
  await printFailures().catch(() => {});
  process.exit(1);
}

const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: STACK }));
const outputs = Object.fromEntries((Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
writeFileSync(path.resolve(here, '..', 'cdk.local-outputs.json'), `${JSON.stringify(outputs, null, 2)}\n`);
console.log(`deployed ${STACK} to LocalStack:`, outputs);
