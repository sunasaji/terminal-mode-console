// agents/echo.mjs — zero-dependency reference implementation
//
// The minimal shape an adapter should implement. Only runTurn needs to be
// written for real. listSessions / getHistory can be empty if unavailable
// (the app will not crash).

export default {
  name: "echo",

  // To show each client what it is connected to (optional; if absent, only name is shown)
  describe() {
    return { label: "echo", model: "-", endpoint: "-" };
  },

  // List of past sessions (empty because this adapter does not persist)
  async listSessions(_limit, _cwd) {
    return [];
  },

  // History. Usually unnecessary because the caller has an implementation that passes the bus-side history as-is.
  async getHistory(_session, _limit) {
    return [];
  },

  // One turn. ctx = { session, text, emit, ask }
  //   emit(event)          : stream one SSE
  //   ask.permission(...)  : ask for permission and wait (Promise)
  //   ask.question(...)    : ask a question and wait (Promise)
  async runTurn(ctx) {
    const { text, emit, session } = ctx;
    const reply = `echo: ${text}`;

    emit({ type: "status", state: "text_start", sessionId: session.id });
    for (const chunk of reply.match(/.{1,8}/gs) ?? []) {
      emit({ type: "text_delta", text: chunk });
      await new Promise((r) => setTimeout(r, 40));
    }
    emit({ type: "status", state: "text_end", sessionId: session.id });

    session.history.push({ role: "assistant", content: reply });
    emit({
      type: "result",
      success: true,
      text: reply,
      sessionId: session.id,
      provider: this.name,
      costUsd: 0,
      turns: 1,
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  },
};
