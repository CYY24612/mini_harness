import { compose, type Ctx, type Plugin } from "./container.ts";

const pluginA: Plugin = (ctx) => {
    ctx.provide("greeting", "hello from A")
}

const pluginB: Plugin = (ctx) => {
    const a = ctx.get("greeting")
    console.log(a)
}

const ctx = compose([pluginA, pluginB])