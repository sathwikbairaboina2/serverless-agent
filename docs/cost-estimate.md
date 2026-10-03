# ServerlessAgent cost estimate

**All numbers are estimates** from public us-east-1 list prices as remembered on 2026-10-03; verify on the AWS pricing pages before relying on them. Nothing here was measured on a real AWS bill.

## Price assumptions (estimates)

| Item | Price |
|---|---|
| Lambda arm64 | $0.0000133334 per GB-s; $0.20 per 1M requests |
| DynamoDB on-demand | $0.625 per 1M write request units; $0.125 per 1M read request units; storage $0.25/GB-month; PITR $0.20/GB-month |
| Step Functions Standard | $0.025 per 1,000 state transitions |
| API Gateway WebSocket | $1.00 per 1M messages; $0.25 per 1M connection-minutes |
| API Gateway REST | $3.50 per 1M requests |
| CloudWatch Logs ingestion | $0.50/GB |
| Amazon Nova Lite | $0.06 per 1M input tokens; $0.24 per 1M output tokens |

## Scenario: one run with one approval (estimate)

Assumptions: 3 model calls, 6,000 input tokens and 600 output tokens in total, two `agentStep` invocations of about 4 s at 1 GB, one approval.

| Component | Arithmetic | Estimate |
|---|---|---|
| Step Functions | 6 transitions × $0.000025 | **$0.00015** |
| Lambda `agentStep` | 2 invocations × 4 s × 1 GB = 8 GB-s × $0.0000133334 | **$0.000107** |
| Lambda small handlers | 3 × 0.2 s × 0.25 GB ≈ 0.15 GB-s ≈ $0.000002; 5 requests × $0.0000002 = $0.000001 | $0.000003 |
| DynamoDB writes | about 32 item writes × about 4 WRU = 128 WRU × $0.000000625 | **$0.00008** |
| DynamoDB reads | about 20 RRU × $0.000000125 | $0.0000025 |
| WebSocket | about 50 batched messages × $0.000001 | **$0.00005** |
| REST approval call | 1 × $0.0000035 | $0.0000035 |
| Bedrock Nova Lite | 6,000 × $0.06/1M = $0.00036, plus 600 × $0.24/1M = $0.000144 | **$0.000504** |
| CloudWatch Logs | about 10 KB × $0.50/GB | $0.000005 |
| **Total** | | **≈ $0.0009 per run (estimate), about $0.90 per 1,000 runs** |

The model is about 55% of the total. Without the `TokenBatcher`, about 300 WebSocket messages would cost about $0.0003 instead of $0.00005.

## Sensitivity: a bigger model

The same run on a Claude-Sonnet-class model at $3/$15 per 1M tokens (estimate) costs about $0.018 (input) + $0.009 (output) = **$0.027 per run**. The model then dominates and the infrastructure is about 1.5% of the total.

## Idle cost

$0 compute. Storage only: DynamoDB GB-month plus PITR, and log storage. A small table and logs come to well under $0.10/month (estimate).

## How to see real numbers

- The EMF metric `ServerlessAgent/EstimatedCostUsd`, dimension `AgentName`. It is computed from token counts and the configured prices, so it is an estimate and not AWS billing data.
- A Logs Insights query on the `agentStep` log group: `fields runId, EstimatedCostUsd | stats sum(EstimatedCostUsd) as usd by runId`
- Activate the cost allocation tag `serverless-agent:agent-name` in the Billing console, so Cost Explorer shows real spend by agent.
