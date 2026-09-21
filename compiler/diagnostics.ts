export type DiagnosticCode = 'BEND-SBF100'|'BEND-SBF101'|'BEND-SBF102'|'BEND-SBF103'|'BEND-SBF104'|'BEND-SBF202'|'BEND-SBF203'|'BEND-SBF201'|'BEND-SBF300';

/** Target failures retain their original detail for existing callers, with a
 * stable category and actionable advice. Upstream checker errors keep their
 * own source diagnostics; this class never invents source positions. */
export class TargetDiagnostic extends Error {
  readonly name='TargetDiagnostic';
  functionName?:string;
  constructor(readonly code:DiagnosticCode,readonly detail:string,readonly hint:string) {
    super();
    Object.defineProperty(this, 'message', {get:()=>this.render(), configurable:true});
  }
  inFunction(name:string) {this.functionName??=name;return this;}
  render() {return `[${this.code}] ${this.detail}${this.functionName?`\nFunction: ${this.functionName}`:''}\nHint: ${this.hint}`;}
  toString(){return this.render();}
  toJSON(){return {code:this.code,message:this.detail,hint:this.hint,...(this.functionName?{function:this.functionName}:{})};}
}

export function targetError(detail:string):TargetDiagnostic {
  let code:DiagnosticCode='BEND-SBF100',hint='Use concrete first-order values and fully applied calls; see docs/subset.md for supported forms.';
  if(/recurs/i.test(detail)) {
    code='BEND-SBF101';hint='Use fixed-capacity storage and a structurally decreasing Nat tail loop; recursive heap data and general recursion are unsupported.';
  } else if(/Nat|fuel/.test(detail)) {
    code='BEND-SBF102';hint='Use Nat fuel from 0 through 64 and recurse only on its predecessor. Split larger work across transactions.';
  } else if(/specialization|generic|erased type parameters/i.test(detail)) {
    code='BEND-SBF103';hint='Provide concrete erased type arguments and finite nonrecursive instances. Value-dependent runtime types are unsupported.';
  } else if(/eight runtime arguments/.test(detail)) {
    code='BEND-SBF104';hint='Group arguments into a concrete record so each runtime function has at most eight arguments.';
  }
  return new TargetDiagnostic(code,detail,hint);
}
