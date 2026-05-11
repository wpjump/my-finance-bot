// functions/api/data.js
export async function onRequestGet({ request, env }) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chat_id");

  if (!chatId) {
    return new Response(JSON.stringify({ error: "Missing chat_id" }), { status: 400 });
  }

  // Ambil semua transaksi milik user tersebut
  const { results } = await env.DB.prepare(
    "SELECT * FROM transactions WHERE chat_id = ? ORDER BY created_at DESC"
  ).bind(chatId).all();

  return new Response(JSON.stringify(results), {
    headers: { "Content-Type": "application/json" }
  });
}
