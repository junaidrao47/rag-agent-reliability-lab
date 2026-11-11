// Seeds the `policies` and `orders` collections for Northwind Goods.
// Safe to re-run: both collections are replaced each time.
import { getDb, closeDb } from "../src/db.js";
import { embed } from "../src/embeddings.js";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);

const policies = [
  {
    title: "Refund Policy",
    version: 3,
    effectiveDate: "2026-06-01",
    isCurrent: true,
    body: "Northwind Goods accepts refund requests within 30 days of the delivery date. Items must be unused and in their original packaging. Approved refunds are issued to the original payment method within 5 to 7 business days. Orders delivered more than 30 days ago are not eligible for a refund.",
  },
  {
    // Outdated on purpose: superseded by version 3 above.
    title: "Refund Policy",
    version: 2,
    effectiveDate: "2025-01-15",
    isCurrent: false,
    body: "Northwind Goods accepts refund requests within 60 days of the delivery date. Items must be unused and in their original packaging. Approved refunds are issued to the original payment method within 10 business days.",
  },
  {
    title: "Returns Policy",
    version: 2,
    effectiveDate: "2026-06-01",
    isCurrent: true,
    body: "To return an item, start a return from the Orders page in your account and print the prepaid return label. Return shipping is free for defective or incorrect items; otherwise a $6.95 return shipping fee is deducted from the refund. Returned items must arrive at our warehouse within 14 days of the return being started.",
  },
  {
    title: "Shipping Times",
    version: 4,
    effectiveDate: "2026-03-10",
    isCurrent: true,
    body: "Orders are processed within 1 to 2 business days. Standard shipping within the United States takes 3 to 5 business days after processing. Express shipping takes 1 to 2 business days and costs $14.99. Standard shipping is free on orders over $50.",
  },
  {
    title: "International Shipping",
    version: 2,
    effectiveDate: "2026-03-10",
    isCurrent: true,
    body: "Northwind Goods ships to Canada, the United Kingdom, the European Union and Australia. International delivery takes 7 to 14 business days. Customs duties and import taxes are the customer's responsibility and are not included in the order total. We do not ship to PO boxes outside the United States.",
  },
  {
    title: "Order Cancellation",
    version: 2,
    effectiveDate: "2026-02-01",
    isCurrent: true,
    body: "An order can be cancelled free of charge while its status is processing. Once an order has shipped it can no longer be cancelled; the customer must wait for delivery and then start a return. Cancelled orders are refunded in full within 3 to 5 business days.",
  },
  {
    title: "Damaged or Defective Items",
    version: 1,
    effectiveDate: "2025-09-01",
    isCurrent: true,
    body: "If an item arrives damaged or defective, contact support within 7 days of delivery with your order ID and a photo of the damage. We will send a free replacement or issue a full refund, whichever the customer prefers, and the customer does not need to pay for return shipping.",
  },
  {
    title: "Warranty",
    version: 1,
    effectiveDate: "2025-09-01",
    isCurrent: true,
    body: "All Northwind Goods branded products carry a 12-month limited warranty from the delivery date covering manufacturing defects. The warranty does not cover normal wear and tear, accidental damage or misuse. Third-party brands are covered by their manufacturer's own warranty.",
  },
  {
    title: "Payment Methods",
    version: 3,
    effectiveDate: "2026-01-05",
    isCurrent: true,
    body: "We accept Visa, Mastercard, American Express, PayPal, Apple Pay and Google Pay. We do not accept cash on delivery, personal checks or cryptocurrency. Cards are charged when the order is placed.",
  },
  {
    title: "Account Deletion",
    version: 1,
    effectiveDate: "2025-11-20",
    isCurrent: true,
    body: "Customers can delete their account from Account Settings, under Privacy. Deletion is permanent and is completed within 30 days. Order records are kept for 7 years for tax and legal reasons, but are no longer linked to the customer's personal profile.",
  },
  {
    title: "Support Hours",
    version: 2,
    effectiveDate: "2026-04-01",
    isCurrent: true,
    body: "Northwind Goods support is available Monday to Friday, 9:00 am to 6:00 pm Eastern Time, by live chat and by email at support@northwindgoods.example. Support is closed on weekends and US federal holidays. Email is answered within one business day.",
  },
];

const order = (n, customerEmail, items, status, orderedDaysAgo, deliveredDaysAgo) => ({
  orderId: `NW-${1000 + n}`,
  customerEmail,
  items,
  status,
  orderedAt: daysAgo(orderedDaysAgo),
  deliveredAt: deliveredDaysAgo == null ? null : daysAgo(deliveredDaysAgo),
});
const item = (name, quantity, price) => ({ name, quantity, price });

const orders = [
  order(1, "ava.chen@example.com", [item("Canvas Tote Bag", 1, 24.0)], "delivered", 9, 5),
  order(2, "liam.patel@example.com", [item("Ceramic Pour-Over Set", 1, 48.5)], "shipped", 3, null),
  order(3, "noah.kim@example.com", [item("Wool Throw Blanket", 2, 65.0)], "processing", 1, null),
  order(4, "mia.garcia@example.com", [item("Walnut Desk Organizer", 1, 39.0)], "delivered", 14, 10),
  order(5, "ethan.brown@example.com", [item("Enamel Camp Mug", 4, 12.0)], "cancelled", 6, null),
  order(6, "sofia.rossi@example.com", [item("Linen Apron", 1, 34.0)], "delivered", 50, 45),
  order(7, "lucas.meyer@example.com", [item("Brass Desk Lamp", 1, 89.0)], "delivered", 25, 20),
  order(8, "emma.wilson@example.com", [item("Leather Key Holder", 2, 18.0)], "shipped", 4, null),
  order(9, "oliver.smith@example.com", [item("Bamboo Cutting Board", 1, 29.0), item("Chef's Knife", 1, 74.0)], "processing", 0, null),
  order(10, "isla.jones@example.com", [item("Scented Candle Trio", 1, 36.0)], "delivered", 70, 64),
  order(11, "ava.chen@example.com", [item("Stoneware Dinner Plates", 4, 16.0)], "delivered", 33, 29),
  order(12, "mason.lee@example.com", [item("Cotton Bath Towels", 3, 22.0)], "cancelled", 12, null),
  order(13, "zoe.martin@example.com", [item("Cast Iron Skillet", 1, 54.0)], "shipped", 2, null),
  order(14, "leo.nguyen@example.com", [item("Insulated Water Bottle", 2, 27.0)], "delivered", 8, 3),
  order(15, "ruby.taylor@example.com", [item("Oak Picture Frame", 3, 19.5)], "processing", 1, null),
];

async function main() {
  const db = await getDb();

  console.log("Embedding policies locally (first run downloads the model)...");
  const policyDocs = [];
  for (const policy of policies) {
    policyDocs.push({
      ...policy,
      embedding: await embed(`${policy.title}\n${policy.body}`),
    });
  }

  await db.collection("policies").deleteMany({});
  await db.collection("policies").insertMany(policyDocs);

  await db.collection("orders").deleteMany({});
  await db.collection("orders").insertMany(orders);
  await db.collection("orders").createIndex({ orderId: 1 }, { unique: true });

  const current = policyDocs.filter((p) => p.isCurrent).length;
  console.log(
    `Seeded ${policyDocs.length} policies (${current} current, ${policyDocs.length - current} outdated) and ${orders.length} orders into "${db.databaseName}".`,
  );
}

try {
  await main();
} catch (error) {
  console.error("Seed failed:", error.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
