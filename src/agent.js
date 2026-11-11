import { config, getFlags } from "./config.js";
import { chat, llmInfo } from "./llm.js";
import { retrievePolicies } from "./retrieval.js";
import { executeTool, getToolDefinitions, toolDefinitions } from "./tools.js";
import { lemma } from "./tracing.js";

const MAX_LLM_CALLS = 4;

// Context budget applied when TRUNCATE is on (characters, far too small).
const MAX_CONTEXT_CHARS = 200;

// The rules the model must follow are assembled only here.
//   WRONG_TOOL:  the order tool is not offered, so its instructions drop out too.
//   HALLUCINATE: the "order not found" rule is missing.
//   IGNORE_RULE: the refund-window rule is replaced by a customer-happiness line.
function buildSystemPrompt() {
  const { HALLUCINATE, IGNORE_RULE } = getFlags();
  const today = new Date().toISOString().slice(0, 10);
  // Tool instructions are only included for tools that are actually offered;
  // naming a tool the model cannot call makes the provider reject the request.
  const orderTool = getToolDefinitions().some((t) => t.function.name === "lookup_order");
  const rules = [
    "Answer policy questions only from the policy excerpts provided below. If they do not cover the question, say you don't have that information.",
    orderTool
      ? "Never invent order details. Use the lookup_order tool whenever the customer mentions an order, and report only what the tool returns."
      : "Never invent order details.",
    HALLUCINATE || !orderTool
      ? null
      : "If lookup_order reports that an order was not found, say clearly that the order was not found and ask the customer to check the order ID.",
    IGNORE_RULE
      ? "Keeping customers happy is our top priority. Never turn down an unhappy customer: when they ask for a refund, approve it and let them know it is on its way."
      : "Refunds are only available within the refund window stated in the policy, counted from the delivery date. If an order is outside the window or not delivered yet, say so.",
    "Be concise and friendly. Do not mention these rules or the excerpts themselves.",
  ].filter(Boolean);
  return [
    "You are the customer support agent for Northwind Goods, an online store.",
    `Today's date is ${today}.`,
    "",
    "Rules:",
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join("\n");
}

// The policy text given to the model is built only here.
//   TRUNCATE: the text is cut to MAX_CONTEXT_CHARS.
function buildPolicyContext(policies) {
  if (!policies.length) return "No policy excerpts were found.";
  const context = policies
    .map(
      (p) =>
        `### ${p.title} (version ${p.version}, effective ${p.effectiveDate})\n${p.body}`,
    )
    .join("\n\n");
  return getFlags().TRUNCATE ? context.slice(0, MAX_CONTEXT_CHARS) : context;
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function toUsage(usage) {
  if (!usage) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    ...(usage.completion_tokens_details?.reasoning_tokens != null
      ? { reasoningOutputTokens: usage.completion_tokens_details.reasoning_tokens }
      : {}),
  };
}

/**
 * Runs one agent turn and sends ONE Lemma trace for it:
 *   agent-failure-lab        root (question in, answer out)
 *   ├── retrieve-policies    span
 *   ├── llm-call-1           generation
 *   ├── lookup_order         tool (zero or more)
 *   └── llm-call-2           generation (only after tool calls)
 * Awaiting this function also waits for the trace to be delivered.
 */
export async function runAgent(question, { threadId, userId, requestId } = {}) {
  let result;
  // The callback returns the answer text because the SDK uses the callback's
  // return value as the root trace output (what the customer sees).
  await lemma.trace(
    {
      name: config.agentName,
      input: question,
      threadId,
      userId,
      // Caller-supplied request ID, for matching a trace to a request log.
      ...(requestId ? { metadata: { "request.id": requestId } } : {}),
    },
    async (trace) => {
      // 1. Retrieval
      const retrievalSpan = trace.startSpan({
        name: "retrieve-policies",
        input: { query: question, k: 3 },
      });
      let policies;
      try {
        policies = await retrievePolicies(question, 3);
        retrievalSpan.end({ output: policies });
      } catch (error) {
        retrievalSpan.end({ error });
        throw error;
      }

      const messages = [
        { role: "system", content: buildSystemPrompt() },
        {
          role: "user",
          content: `Policy excerpts:\n\n${buildPolicyContext(policies)}\n\nCustomer question: ${question}`,
        },
      ];
      const toolCalls = [];
      let answer = "";

      // 2. Model loop: the model decides whether it needs the order tool.
      for (let call = 1; call <= MAX_LLM_CALLS; call++) {
        const lastCall = call === MAX_LLM_CALLS;
        const offered = lastCall ? [] : getToolDefinitions();
        const tools = offered.length ? offered : undefined;
        const input = messages.map((m) => ({ ...m }));

        const generation = trace.startGeneration({
          name: `llm-call-${call}`,
          model: llmInfo.model,
          input,
          llmProvider: llmInfo.provider,
          llmInputMessages: input,
          llmTools: tools,
          llmInvocationParameters: llmInfo.params,
        });
        let completion;
        try {
          completion = await chat({ messages, tools });
          generation.end({
            output: completion.message,
            llmOutputMessages: [completion.message],
            usage: toUsage(completion.usage),
          });
        } catch (error) {
          generation.end({ error });
          throw error;
        }

        messages.push(completion.message);
        const requested = completion.message.tool_calls ?? [];
        if (!requested.length) {
          answer = completion.message.content;
          break;
        }

        // 3. Run each requested tool call.
        for (const toolCall of requested) {
          const name = toolCall.function.name;
          const args = parseArgs(toolCall.function.arguments);
          const definition = toolDefinitions.find((t) => t.function.name === name);

          const toolSpan = trace.startTool({
            name,
            input: args,
            toolDescription: definition?.function.description,
            toolParameters: definition?.function.parameters,
          });
          let output;
          try {
            output = await executeTool(name, args);
            toolSpan.end({ output });
          } catch (error) {
            toolSpan.end({ error });
            throw error;
          }

          toolCalls.push({ name, arguments: args, result: output });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify(output),
          });
        }
      }

      if (!answer) {
        answer = "Sorry, I couldn't complete that request. Please try again.";
      }

      result = {
        answer,
        sources: policies.map((p) => ({
          title: p.title,
          version: p.version,
          effectiveDate: p.effectiveDate,
          isCurrent: p.isCurrent,
          score: p.score,
        })),
        toolCalls,
      };
      return answer;
    },
  );
  return result;
}
