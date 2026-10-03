import { Duration } from 'aws-cdk-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { definitionOf, synthAgent } from './support/template-helpers';

describe('run state machine', () => {
  let def: any;
  let t: ReturnType<typeof synthAgent>['template'];
  beforeAll(() => { t = synthAgent().template; def = definitionOf(t); });

  it('is a STANDARD state machine starting at RunAgent', () => {
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD' });
    expect(def.StartAt).toBe('RunAgent');
    expect(def.TimeoutSeconds).toBe(7 * 24 * 3600);
  });

  it('passes run id and whole state to the agent and stores the result under $.step', () => {
    const s = def.States.RunAgent;
    expect(s.Parameters).toEqual({ 'runId.$': '$$.Execution.Name', 'input.$': '$' });
    expect(s.ResultPath).toBe('$.step');
    expect(s.Next).toBe('NeedsApproval?');
    expect(s.Catch[0].Next).toBe('RunFailed');
  });

  it('branches on interrupted', () => {
    const c = def.States['NeedsApproval?'];
    expect(c.Choices[0]).toMatchObject({ Variable: '$.step.status', StringEquals: 'interrupted', Next: 'WaitForApproval' });
    expect(c.Default).toBe('RunCompleted');
  });

  it('waits for a human with a task token, a timeout, and loops back to RunAgent', () => {
    const w = def.States.WaitForApproval;
    expect(w.Resource).toMatch(/:states:::lambda:invoke\.waitForTaskToken$/);
    expect(w.Parameters.Payload['taskToken.$']).toBe('$$.Task.Token');
    expect(w.Parameters.Payload['runId.$']).toBe('$$.Execution.Name');
    expect(w.TimeoutSeconds).toBe(86400);
    expect(w.ResultPath).toBe('$.resume');
    expect(w.Next).toBe('RunAgent');
    expect(w.Catch).toEqual(expect.arrayContaining([
      expect.objectContaining({ ErrorEquals: ['States.Timeout'], Next: 'ApprovalTimedOut' }),
      expect.objectContaining({ ErrorEquals: ['States.ALL'], Next: 'RunFailed' }),
    ]));
  });

  it('has terminal states', () => {
    expect(def.States.RunCompleted.Type).toBe('Succeed');
    expect(def.States.RunFailed).toMatchObject({ Type: 'Fail', Error: 'AgentRunFailed' });
    expect(def.States.ApprovalTimedOut).toMatchObject({ Type: 'Fail', Error: 'ApprovalTimedOut' });
  });

  it('honours approvalTimeout and maxRunDuration props', () => {
    const d = definitionOf(synthAgent({ approvalTimeout: Duration.hours(1), maxRunDuration: Duration.days(2) }).template);
    expect(d.States.WaitForApproval.TimeoutSeconds).toBe(3600);
    expect(d.TimeoutSeconds).toBe(2 * 24 * 3600);
  });

  it('lets only the approval callback send task responses', () => {
    const stmts = JSON.stringify(t.findResources('AWS::IAM::Policy'));
    expect(stmts).toContain('states:SendTaskSuccess');
  });
});
