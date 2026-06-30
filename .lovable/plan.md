The app is showing that message because earlier backend evidence indicated the AI Gateway rejected requests due to exhausted AI credits. I checked the current workspace AI Gateway balance and it now shows **5 daily AI Gateway credits remaining**, so the credit balance appears to have refreshed.

Plan:
1. Re-test the chat send flow in the app to see whether it now responds with the refreshed daily AI credits.
2. If it still fails, inspect the latest `/api/chat` network response and AI Gateway logs to identify the new exact backend error.
3. If the app is still showing the old credit error after credits are available, update the chat UI to clear stale errors as soon as a new message is submitted and replace empty assistant placeholders with a clear retry/error state.
4. Keep the existing credit-exhausted message for real `402` failures, because that is the correct production behavior when AI Gateway credits run out.

Expected result: when credits are available, JABBI AI should answer normally; when credits are truly exhausted, users get a clear billing/credits message instead of a silent non-response.