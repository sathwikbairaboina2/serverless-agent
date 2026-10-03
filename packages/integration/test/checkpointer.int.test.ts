import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { validate } from '@langchain/langgraph-checkpoint-validation';
import { DynamoDBSaver } from '@serverless-agent/runtime';
import { assertLocalStackReady, clientConfig } from './support/localstack.js';

const raw = new DynamoDBClient(clientConfig);
const doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const tables = new WeakMap<DynamoDBSaver, string>();
let n = 0;

validate({
  checkpointerName: 'DynamoDBSaver (LocalStack DynamoDB)',
  beforeAll: assertLocalStackReady,
  beforeAllTimeout: 30_000,
  async createCheckpointer() {
    const tableName = `conformance-${Date.now()}-${n++}`;
    await raw.send(new CreateTableCommand({
      TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
    }));
    await waitUntilTableExists({ client: raw, maxWaitTime: 30 }, { TableName: tableName });
    const saver = new DynamoDBSaver({ client: doc, tableName, ttlSeconds: 3600 });
    tables.set(saver, tableName);
    return saver;
  },
  async destroyCheckpointer(saver) {
    const name = tables.get(saver as DynamoDBSaver);
    if (name) await raw.send(new DeleteTableCommand({ TableName: name }));
  },
});
