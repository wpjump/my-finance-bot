// functions/api/webhook.js

export async function onRequestPost({ request, env }) {
  try {
    // Parse the incoming JSON payload from Telegram
    const update = await request.json();
    
    // Log the incoming message (visible in Cloudflare Dashboard)
    console.log("Incoming Telegram Update:", JSON.stringify(update, null, 2));

    // Return 200 OK so Telegram knows the webhook was received
    return new Response("OK", { status: 200 });
  } catch (error) {
    return new Response("Error processing request", { status: 500 });
  }
}
