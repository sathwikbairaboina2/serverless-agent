import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ServerlessAgent, type ServerlessAgentProps } from '../../src';

export function synthAgent(props?: ServerlessAgentProps) {
  const app = new App();
  const stack = new Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  const agent = new ServerlessAgent(stack, 'Agent', props);
  return { app, stack, agent, template: Template.fromStack(stack) };
}

/** Flattens CFN intrinsics into a readable string so tests can match ARNs. */
export function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(flat).join(',');
  if (v && typeof v === 'object') {
    const o = v as Record<string, any>;
    if (o['Fn::Join']) return (o['Fn::Join'][1] as unknown[]).map(flat).join(o['Fn::Join'][0]);
    if (o.Ref) return `{${o.Ref}}`;
    if (o['Fn::GetAtt']) return `{${([] as string[]).concat(o['Fn::GetAtt']).join('.')}}`;
    return JSON.stringify(o);
  }
  return String(v);
}

export interface Stmt { Effect: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; roles: string[] }

export const actionsOf = (s: Stmt): string[] => ([] as string[]).concat(s.Action ?? []);

export function allStatements(t: Template): Stmt[] {
  const out: Stmt[] = [];
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as any[]) {
    const roles = (p.Properties.Roles ?? []).map((r: any) => r.Ref);
    for (const s of p.Properties.PolicyDocument.Statement) out.push({ ...s, roles });
  }
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role')) as [string, any][]) {
    for (const pol of r.Properties.Policies ?? []) for (const s of pol.PolicyDocument.Statement) out.push({ ...s, roles: [id] });
  }
  return out;
}

export function roleOfFunction(t: Template, handler: string): string {
  const fns = Object.values(t.findResources('AWS::Lambda::Function', { Properties: { Handler: handler } })) as any[];
  if (fns.length !== 1) throw new Error(`expected exactly one function with handler ${handler}, found ${fns.length}`);
  return fns[0].Properties.Role['Fn::GetAtt'][0];
}

export function statementsForFunction(t: Template, handler: string): Stmt[] {
  const role = roleOfFunction(t, handler);
  return allStatements(t).filter((s) => s.roles.includes(role));
}

export function definitionOf(t: Template): any {
  const sm = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0] as any;
  const ds = sm.Properties.DefinitionString;
  const text = typeof ds === 'string' ? ds : (ds['Fn::Join'][1] as unknown[]).map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('');
  return JSON.parse(text);
}
