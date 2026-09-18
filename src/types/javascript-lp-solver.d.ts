declare module 'javascript-lp-solver' {
  export interface IModel {
    optimize: string;
    opType: 'min' | 'max';
    constraints: Record<string, { min?: number; max?: number; equal?: number }>;
    variables: Record<string, Record<string, number>>;
    ints?: Record<string, number>;
  }

  export interface ISolution {
    feasible: boolean;
    result: number;
    [key: string]: number | boolean;
  }

  export function Solve(model: IModel): ISolution;
  const solver: {
    Solve(model: IModel): ISolution;
  };
  export default solver;
}
