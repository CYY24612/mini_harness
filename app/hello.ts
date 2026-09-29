import { greet } from './greet.ts'

function add(a: number, b: number): number
{
    return a + b;
}

console.log(greet('世界'), add(1, 2));