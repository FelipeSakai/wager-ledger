import { SQSClient } from '@aws-sdk/client-sqs';

export function sqsClient(
  options: { endpoint?: string; region?: string; local?: boolean } = {},
): SQSClient {
  return new SQSClient({
    endpoint: options.endpoint,
    region: options.region ?? 'us-east-1',
    maxAttempts: 1,
    useQueueUrlAsEndpoint: false,
    ...(options.local ? { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {}),
  });
}
