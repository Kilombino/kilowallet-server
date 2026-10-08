# Kilowallet server container. The jar is built on the build machine's own platform (it is the same
# bytecode everywhere), then copied onto a JRE for each target architecture.
FROM --platform=$BUILDPLATFORM eclipse-temurin:17-jdk AS build
WORKDIR /src
COPY . .
RUN ./gradlew --no-daemon -q fatJar

FROM eclipse-temurin:17-jre
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/libs/kilowallet-server.jar /opt/kilowallet/kilowallet-server.jar
ENV KILOWALLET_DATA=/data KILOWALLET_PORT=8080
EXPOSE 8080
ENTRYPOINT ["java", "-Xmx256m", "-jar", "/opt/kilowallet/kilowallet-server.jar"]
