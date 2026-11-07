import { compose, type PluginEntry, type Ctx, type Plugin } from "./container.ts";

const provider: PluginEntry = {
    id: "provider",
    plugin: (ctx) => {
        ctx.provide("greeting", "hello from A")
    },
}

const consumer: PluginEntry = {
    id: "consumer",
    plugin: (ctx: Ctx) => {
        const a = ctx.get("greeting")
        console.log(a)  
    },
    inject: ["greeting"]
}

const ctx = compose([provider, consumer])