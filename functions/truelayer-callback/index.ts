import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    // Handle OAuth error
    if (error) {
      return new Response(
        `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Connection Failed</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100vh;
                margin: 0;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              }
              .container {
                background: white;
                padding: 40px;
                border-radius: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3);
                text-align: center;
                max-width: 400px;
              }
              .error-icon {
                font-size: 64px;
                margin-bottom: 20px;
              }
              h1 {
                color: #e53e3e;
                margin-bottom: 10px;
              }
              p {
                color: #666;
                line-height: 1.6;
              }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="error-icon">❌</div>
              <h1>Connection Failed</h1>
              <p>The bank connection was cancelled or failed.</p>
              <p style="font-size: 14px; color: #999;">Error: ${error}</p>
            </div>
          </body>
        </html>
        `,
        {
          headers: { "Content-Type": "text/html" },
          status: 400,
        }
      );
    }

    // Validate code
    if (!code) {
      return new Response(
        JSON.stringify({ error: "No authorization code received" }),
        {
          headers: { "Content-Type": "application/json" },
          status: 400,
        }
      );
    }

    console.log("Received auth code:", code.substring(0, 10) + "...");

    // Exchange code for token
    const functionUrl = Deno.env.get("SUPABASE_URL")!.replace(
      "https://",
      "https://"
    );
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const exchangeResponse = await fetch(
      `${functionUrl}/functions/v1/truelayer-exchange-token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ code }),
      }
    );

    if (!exchangeResponse.ok) {
      const error = await exchangeResponse.text();
      console.error("Token exchange failed:", error);
      throw new Error("Failed to exchange authorization code");
    }

    const { access_token } = await exchangeResponse.json();
    console.log("Token obtained successfully");

    // Sync accounts and transactions
    const syncResponse = await fetch(
      `${functionUrl}/functions/v1/truelayer-sync-accounts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ access_token }),
      }
    );

    if (!syncResponse.ok) {
      const error = await syncResponse.text();
      console.error("Account sync failed:", error);
      throw new Error("Failed to sync accounts");
    }

    const syncResult = await syncResponse.json();
    console.log("Sync completed:", syncResult);

    // Success page
    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Bank Connected! ✅</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 20px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 400px;
            }
            .success-icon {
              font-size: 64px;
              margin-bottom: 20px;
              animation: bounce 0.5s ease;
            }
            @keyframes bounce {
              0%, 100% { transform: translateY(0); }
              50% { transform: translateY(-20px); }
            }
            h1 {
              color: #48bb78;
              margin-bottom: 10px;
            }
            p {
              color: #666;
              line-height: 1.6;
              margin-bottom: 20px;
            }
            .stats {
              background: #f7fafc;
              padding: 20px;
              border-radius: 10px;
              margin: 20px 0;
            }
            .stat {
              display: flex;
              justify-content: space-between;
              padding: 8px 0;
              border-bottom: 1px solid #e2e8f0;
            }
            .stat:last-child {
              border-bottom: none;
            }
            .stat-label {
              color: #718096;
              font-size: 14px;
            }
            .stat-value {
              color: #2d3748;
              font-weight: 600;
            }
            .close-button {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              border: none;
              padding: 12px 30px;
              border-radius: 25px;
              font-size: 16px;
              font-weight: 600;
              cursor: pointer;
              margin-top: 20px;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="success-icon">🎉</div>
            <h1>Bank Connected!</h1>
            <p>Your European bank account has been successfully connected to WiseFlow.</p>
            
            <div class="stats">
              <div class="stat">
                <span class="stat-label">Accounts synced</span>
                <span class="stat-value">${syncResult.accounts_count || 0}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Transactions imported</span>
                <span class="stat-value">${syncResult.transactions_count || 0}</span>
              </div>
            </div>
            
            <p style="font-size: 14px; color: #999;">You can now close this window and return to WiseFlow.</p>
            <button class="close-button" onclick="window.close()">Close Window</button>
          </div>
        </body>
      </html>
      `,
      {
        headers: { "Content-Type": "text/html" },
        status: 200,
      }
    );
  } catch (error) {
    console.error("Callback error:", error);
    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Connection Error</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              min-height: 100vh;
              margin: 0;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container {
              background: white;
              padding: 40px;
              border-radius: 20px;
              box-shadow: 0 20px 60px rgba(0,0,0,0.3);
              text-align: center;
              max-width: 400px;
            }
            .error-icon {
              font-size: 64px;
              margin-bottom: 20px;
            }
            h1 {
              color: #e53e3e;
              margin-bottom: 10px;
            }
            p {
              color: #666;
              line-height: 1.6;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="error-icon">⚠️</div>
            <h1>Something Went Wrong</h1>
            <p>We encountered an error while connecting your bank account.</p>
            <p style="font-size: 14px; color: #999;">Please try again or contact support if the problem persists.</p>
          </div>
        </body>
      </html>
      `,
      {
        headers: { "Content-Type": "text/html" },
        status: 500,
      }
    );
  }
});
