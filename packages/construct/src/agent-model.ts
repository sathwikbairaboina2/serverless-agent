import { Aws, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

export interface ModelPricing {
  /** USD per 1M input tokens (used for ESTIMATED cost metrics only). */
  readonly inputUsdPerMillionTokens: number;
  /** USD per 1M output tokens (used for ESTIMATED cost metrics only). */
  readonly outputUsdPerMillionTokens: number;
}

export interface BedrockModelOptions { readonly pricing?: ModelPricing }

export interface OpenAiCompatibleModelProps {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKeySecret?: secretsmanager.ISecret;
  readonly pricing?: ModelPricing;
}

export interface AgentModelBinding { readonly environment: { [key: string]: string } }

const ZERO: ModelPricing = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 };
const priceEnv = (p: ModelPricing) => ({
  PRICE_INPUT_USD_PER_MTOK: String(p.inputUsdPerMillionTokens),
  PRICE_OUTPUT_USD_PER_MTOK: String(p.outputUsdPerMillionTokens),
});

export abstract class AgentModel {
  public static readonly DEFAULT_BEDROCK_MODEL_ID = 'amazon.nova-lite-v1:0';
  /** ESTIMATE of Amazon Nova Lite on-demand pricing (verify on the Bedrock pricing page). */
  public static readonly DEFAULT_BEDROCK_PRICING: ModelPricing = { inputUsdPerMillionTokens: 0.06, outputUsdPerMillionTokens: 0.24 };

  public static bedrock(modelId?: string, options?: BedrockModelOptions): AgentModel {
    return new BedrockModel(modelId ?? AgentModel.DEFAULT_BEDROCK_MODEL_ID, options ?? {});
  }

  public static openAiCompatible(props: OpenAiCompatibleModelProps): AgentModel {
    return new OpenAiCompatibleModel(props);
  }

  public abstract readonly modelId: string;
  public abstract bind(grantee: iam.IGrantable): AgentModelBinding;
}

class BedrockModel extends AgentModel {
  constructor(public readonly modelId: string, private readonly options: BedrockModelOptions) {
    super();
    if (!modelId) throw new Error('AgentModel.bedrock: modelId must not be empty');
  }

  public bind(grantee: iam.IGrantable): AgentModelBinding {
    const profile = /^(us|eu|apac|us-gov|global)\.(.+)$/.exec(this.modelId);
    const resourceArns = profile
      ? [
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/${this.modelId}`,
          `arn:${Aws.PARTITION}:bedrock:*::foundation-model/${profile[2]}`,
        ]
      : [`arn:${Aws.PARTITION}:bedrock:${Aws.REGION}::foundation-model/${this.modelId}`];
    iam.Grant.addToPrincipal({ grantee, actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], resourceArns });
    const pricing = this.options.pricing ?? (this.modelId === AgentModel.DEFAULT_BEDROCK_MODEL_ID ? AgentModel.DEFAULT_BEDROCK_PRICING : ZERO);
    return { environment: { MODEL_PROVIDER: 'bedrock', MODEL_ID: this.modelId, ...priceEnv(pricing) } };
  }
}

class OpenAiCompatibleModel extends AgentModel {
  public readonly modelId: string;

  constructor(private readonly props: OpenAiCompatibleModelProps) {
    super();
    if (!Token.isUnresolved(props.baseUrl) && !/^https?:\/\//.test(props.baseUrl)) {
      throw new Error(`AgentModel.openAiCompatible: baseUrl must start with http:// or https:// (got "${props.baseUrl}")`);
    }
    if (!props.modelId) throw new Error('AgentModel.openAiCompatible: modelId must not be empty');
    this.modelId = props.modelId;
  }

  public bind(grantee: iam.IGrantable): AgentModelBinding {
    const environment: { [key: string]: string } = {
      MODEL_PROVIDER: 'openai-compatible', MODEL_ID: this.modelId, MODEL_BASE_URL: this.props.baseUrl,
      ...priceEnv(this.props.pricing ?? ZERO),
    };
    if (this.props.apiKeySecret) {
      this.props.apiKeySecret.grantRead(grantee);
      environment.MODEL_API_KEY_SECRET_ARN = this.props.apiKeySecret.secretArn;
    }
    return { environment };
  }
}
