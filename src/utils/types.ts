import { Node as ESTreeNode } from 'estree';
export type Ast = { body: ESTreeNode[] };


export interface StaticValue {
    value: any;
    wildcards?: string[];
  }
  
  export interface ConditionalValue {
    test: string;
    then: any;
    else: any;
  }
  
  export type EvaluatedValue = StaticValue | ConditionalValue | undefined;