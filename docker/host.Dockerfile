# Runtime for the exact same archive used by the native installation.
# The first archive supports only this architecture; keep the interpreter and
# native tools on the same platform even with a classic cross-host builder.
FROM --platform=linux/amd64 docker.io/library/alpine:3.23
RUN apk add --no-cache python3 ca-certificates
WORKDIR /opt/ptn
COPY release/ptn-linux-x86_64/ ./
ENTRYPOINT ["python3", "/opt/ptn/examples/native/host.py", "--config", "/config/config.json"]
CMD ["serve"]
