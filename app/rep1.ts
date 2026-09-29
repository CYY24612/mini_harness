import { createInterface } from 'node:readline/promises'

const r1 = createInterface({ input: process.stdin, output: process.stdout})
const history: string[] = []

for (;;)
{

    const answer = await r1.question('你 > ')
    if (answer == 'break') break;
    history.push(answer)
    console.log(answer, history.length)

}
r1.close()