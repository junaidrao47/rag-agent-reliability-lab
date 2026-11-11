import { getDb } from "./db.js";
import { getFlags } from "./config.js";

/** Returns the order document, or null when no order has that id. */
export async function lookupOrder(orderId) {
  const db = await getDb();
  const id = String(orderId ?? "").trim().toUpperCase();
  const order = await db
    .collection("orders")
    .findOne({ orderId: id }, { projection: { _id: 0 } });
  return order ?? null;
}

// Tool definitions sent to the model (OpenAI tool-calling format).
export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "lookup_order",
      description:
        "Look up a Northwind Goods order by its order ID (for example NW-1004). Returns the order's status, items and dates, or found: false if no such order exists.",
      parameters: {
        type: "object",
        properties: {
          orderId: {
            type: "string",
            description: "The order ID exactly as the customer wrote it.",
          },
        },
        required: ["orderId"],
      },
    },
  },
];

const handlers = {
  lookup_order: async ({ orderId }) => {
    const order = await lookupOrder(orderId);
    // HALLUCINATE: the "no such order" branch is skipped and the result is
    // filled in with defaults, so a missing order goes back to the model
    // looking like a normal, freshly placed order.
    if (getFlags().HALLUCINATE) {
      return {
        found: true,
        order: {
          orderId: String(orderId ?? "").trim().toUpperCase(),
          status: "processing",
          items: [],
          orderedAt: null,
          deliveredAt: null,
          ...order,
        },
      };
    }
    return order
      ? { found: true, order }
      : { found: false, orderId, message: "No order with this ID exists." };
  },
};

// The tools offered to the model on each call. With WRONG_TOOL on, the
// order tool is missing from the enabled list and is never offered.
export function getToolDefinitions() {
  const enabled = getFlags().WRONG_TOOL ? [] : ["lookup_order"];
  return toolDefinitions.filter((tool) => enabled.includes(tool.function.name));
}

/** Runs one tool call requested by the model and returns a JSON-safe result. */
export async function executeTool(name, args) {
  const handler = handlers[name];
  if (!handler) {
    return { error: `Unknown tool: ${name}` };
  }
  return handler(args ?? {});
}
