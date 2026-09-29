
import { createInterface } from 'node:readline/promises'
try { process.loadEnvFile('.env') } catch {}

const r1 = createInterface({ input: process.stdin, output: process.stdout})

type ChatMessage = {
    role: 'user' | 'assistant'
    content: string
}
const history: ChatMessage[] = []


const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
    console.log('缺少 OPENAI_API_KEY')
    process.exit(1)
}

const baseUrl = process.env.OPENAI_BASE_URL
const model = process.env.AGENT_MODEL

for (;;)
{

    const answer = await r1.question('你 > ')
    if (answer === 'break') break;

    history.push({ role: 'user', content: answer })

    try {

        const body = { model, messages: history, "stream": true}
        const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
        })

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`)
        }

        let buffer = '' 
        let full = ''
        let inThinking = false
        const decoder = new TextDecoder()
        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true })
            
            while (buffer.indexOf('\n\n') !== -1)
            {
                const p = buffer.indexOf('\n\n')
                const event = buffer.slice(0, p)
                buffer = buffer.slice(p + 2)
                
                const payload = event.slice(5).trim()
                if (payload === '[DONE]') break
                
                const parsed = JSON.parse(payload)
                // const think = parsed.choices?.[0]?.delta?.reasoning_content
                // if (think) {
                //     if (!inThinking) { process.stdout.write('\n💭 '); inThinking = true }
                //     process.stdout.write(think)
                // }
                const piece = parsed.choices?.[0]?.delta?.content
                if (piece) {
                    // if (inThinking) { process.stdout.write('\n\n'); inThinking = false }
                    process.stdout.write(piece)
                    full += piece
                }
            }
            
        }
        console.log()
        history.push({ role: 'assistant', content: full})

    } catch (err) {
        console.log('\n请求失败:', err instanceof Error ? err.message : String(err))
        history.pop()
        continue
    }
}
r1.close()