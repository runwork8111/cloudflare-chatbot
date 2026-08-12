export interface Env {
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return Response.json({
      ok: true,
      service: "chatbot-worker",
      environment: env.ENVIRONMENT,
    });
  },
} satisfies ExportedHandler<Env>;
