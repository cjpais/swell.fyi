// Temporary multipart uploader into R2 via the Worker binding. Every request needs
// the UPLOAD_TOKEN secret. Delete this Worker after use.
interface Env {
  BUCKET: R2Bucket;
  UPLOAD_TOKEN: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.UPLOAD_TOKEN || req.headers.get("x-upload-token") !== env.UPLOAD_TOKEN) return new Response("Forbidden", { status: 403 });
    const url = new URL(req.url);
    const key = url.searchParams.get("key");
    if (!key) return new Response("key required", { status: 400 });

    if (req.method === "POST" && url.pathname === "/create") {
      const contentType = url.searchParams.get("type") ?? "application/octet-stream";
      const mpu = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType, cacheControl: "public, max-age=86400" } });
      return Response.json({ uploadId: mpu.uploadId });
    }
    const uploadId = url.searchParams.get("uploadId");
    if (!uploadId) return new Response("uploadId required", { status: 400 });
    const mpu = env.BUCKET.resumeMultipartUpload(key, uploadId);

    if (req.method === "PUT" && url.pathname === "/part") {
      const n = Number(url.searchParams.get("n"));
      const part = await mpu.uploadPart(n, req.body!);
      return Response.json(part);
    }
    if (req.method === "POST" && url.pathname === "/complete") {
      const obj = await mpu.complete(await req.json());
      return Response.json({ key: obj.key, size: obj.size, etag: obj.etag });
    }
    if (req.method === "POST" && url.pathname === "/abort") {
      await mpu.abort();
      return new Response("aborted");
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
