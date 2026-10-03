import { validate } from '@langchain/langgraph-checkpoint-validation';
import { DynamoDBSaver } from '../../src/checkpointer/dynamodb-saver.js';
import { FakeDocumentClient } from '../support/fake-document-client.js';

validate({
  checkpointerName: 'DynamoDBSaver (in-memory DynamoDB fake)',
  createCheckpointer: () => new DynamoDBSaver({ client: new FakeDocumentClient({ maxPageSize: 3 }), tableName: 'conformance' }),
});
