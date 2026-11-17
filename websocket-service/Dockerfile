FROM golang:1.27.4-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build

WORKDIR /src
ENV CGO_ENABLED=0 GOTOOLCHAIN=local

COPY go.mod go.sum ./
RUN go mod download && go mod verify
COPY *.go ./
RUN go build -mod=readonly -trimpath -buildvcs=false -o /out/relay .

FROM scratch

COPY --from=build /out/relay /relay
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt

USER 65532:65532
ENV GO_WS_ADDR=0.0.0.0:8090
EXPOSE 8090
ENTRYPOINT ["/relay"]
