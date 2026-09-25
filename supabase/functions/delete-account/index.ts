import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

async function stripeRequest(path: string, init: RequestInit = {}) {
  if (!STRIPE_SECRET_KEY) throw new Error("Stripe is not configured.");

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Basic ${btoa(`${STRIPE_SECRET_KEY}:`)}`);
  headers.set("Content-Type", "application/x-www-form-urlencoded");

  return fetch(`https://api.stripe.com/v1/${path}`, { ...init, headers });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Authentication required." }, 401);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json({ error: "Supabase server configuration is missing." }, 500);
  }

  // This client is scoped to the caller's JWT, so the function can only
  // discover/delete the account belonging to the person making the request.
  const userClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: userError } = await userClient.auth.getUser();

  if (userError || !user) {
    return json({ error: "Your session is invalid or expired." }, 401);
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Read the Stripe subscription before deleting the entitlement row.
  const { data: entitlement, error: entitlementError } = await admin
    .from("user_entitlements")
    .select("stripe_subscription_id, stripe_customer_id, subscription_status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (entitlementError) {
    console.error("Could not read entitlement:", entitlementError);
    return json({ error: "Could not prepare account deletion. Nothing was deleted." }, 500);
  }

  const subscriptionId = entitlement?.stripe_subscription_id;

  if (subscriptionId) {
    try {
      const stripeGet = await stripeRequest(`subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "GET",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });

      if (stripeGet.ok) {
        const subscription = await stripeGet.json();

        if (subscription.status !== "canceled") {
          const stripeCancel = await stripeRequest(
            `subscriptions/${encodeURIComponent(subscriptionId)}`,
            { method: "DELETE" },
          );

          if (!stripeCancel.ok) {
            const details = await stripeCancel.text();
            console.error("Stripe cancellation failed:", details);
            return json({
              error: "Your subscription could not be cancelled, so your account was not deleted. Please try again or contact Rengchr@gmail.com.",
            }, 502);
          }
        }
      } else if (stripeGet.status !== 404) {
        const details = await stripeGet.text();
        console.error("Stripe subscription lookup failed:", details);
        return json({
          error: "Your subscription could not be verified, so your account was not deleted. Please try again or contact Rengchr@gmail.com.",
        }, 502);
      }
      // A 404 means the Stripe subscription no longer exists; deletion can continue.
    } catch (err) {
      console.error("Stripe request failed:", err);
      return json({
        error: "Your subscription could not be verified, so your account was not deleted. Please try again or contact Rengchr@gmail.com.",
      }, 502);
    }
  }

  // Remove Plate Logic's subscription/account entitlement data first.
  const { error: deleteEntitlementError } = await admin
    .from("user_entitlements")
    .delete()
    .eq("user_id", user.id);

  if (deleteEntitlementError) {
    console.error("Could not delete entitlement:", deleteEntitlementError);
    return json({ error: "The account was not deleted. Please try again." }, 500);
  }

  // Supabase recommends auth.admin.deleteUser() for account removal.
  const { error: deleteUserError } = await admin.auth.admin.deleteUser(user.id);

  if (deleteUserError) {
    console.error("Could not delete auth user:", deleteUserError);
    return json({
      error: "Some account data could not be deleted automatically. Please contact Rengchr@gmail.com.",
    }, 500);
  }

  return json({ success: true });
});
