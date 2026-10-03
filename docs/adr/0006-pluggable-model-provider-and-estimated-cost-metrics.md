# ADR 0006: Pluggable model provider (Bedrock by default) and estimated cost metrics

Status: accepted, 2026-10-03

## Decision

- The construct API is `AgentModel.bedrock(modelId?, { pricing? })` and `AgentModel.openAiCompatible({ baseUrl, modelId, apiKeySecret?, pricing? })`. `bind(grantee)` grants exactly what the provider needs and returns Lambda environment variables.
  - Bedrock grants `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`, scoped to `foundation-model/<id>` in the stack region. For a geo inference profile id (`us.`, `eu.`, `apac.`, `us-gov.`, `global.` prefix), it grants the profile ARN plus `foundation-model/<base id>` in any region, because profiles route across regions.
  - OpenAI-compatible grants read access on the given Secrets Manager secret only (`secret.grantRead`).
- The default model is Amazon Nova Lite (`amazon.nova-lite-v1:0`): cheap, available on demand in-region without an inference profile, and supports tool use and ConverseStream.
- On LocalStack, Bedrock is Ultimate-plan only (ADR 0009). The local stack therefore uses `openAiCompatible` pointed at the deterministic `mock-llm` container.
- The runtime uses `ChatBedrockConverse` (`@langchain/aws`) or `ChatOpenAI` (`@langchain/openai`) with `configuration.baseURL`. Local development points the OpenAI-compatible provider at Ollama (`http://localhost:11434/v1`).
- Cost: each `agentStep` sums `usage_metadata` over the AI messages it added and multiplies by the configured pricing. It logs one CloudWatch EMF line in namespace `ServerlessAgent`, dimension `AgentName`, with the metrics `InputTokens`, `OutputTokens`, `EstimatedCostUsd` and `StepDurationMs`. `runId` and `threadId` are EMF properties, not dimensions, to avoid a metric-cardinality bill.
- Default pricing applies only to the default model: $0.06 input and $0.24 output per 1M tokens. That is an **estimate**, recalled from public pricing and to be verified on the Bedrock pricing page. Other models default to 0 and should pass `pricing`.

## Consequences

- What we gave up: exact billing. EMF cost is an estimate from token counts, not AWS billing data. Cost allocation tags (`serverless-agent:agent-name`) let Cost Explorer show the real numbers once the tags are activated in the Billing console.
