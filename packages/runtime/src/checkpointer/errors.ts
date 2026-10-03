export class InvalidKeyError extends Error {
  constructor(field: string, value: unknown) {
    super(`Invalid ${field} ${JSON.stringify(value)}: must be a string without "#" (max 512 chars)`);
    this.name = 'InvalidKeyError';
  }
}

export class CheckpointTooLargeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`Serialized checkpoint is ${bytes} bytes; DynamoDBSaver limit is ${limit} bytes (DynamoDB items max 400 KB). Trim state or offload large values.`);
    this.name = 'CheckpointTooLargeError';
  }
}
