declare module 'solc' {
  export function compile(input: string): string;
  export function version(): string;
}
