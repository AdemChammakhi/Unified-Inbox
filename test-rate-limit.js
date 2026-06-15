const http = require("http");

console.log("Démarrage du test de Rate Limiting...");

for (let i = 1; i <= 55; i++) {
  const data = JSON.stringify({ email: "test@test.com", password: "123" });

  const options = {
    hostname: "localhost",
    port: 5000,
    path: "/api/auth/login",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": data.length,
    },
  };

  const req = http.request(options, (res) => {
    if (res.statusCode === 429) {
      console.log(`❌ Requête ${i} : Code ${res.statusCode} (BLOQUÉ par le Rate Limiter !)`);
    } else {
      console.log(`✅ Requête ${i} : Code ${res.statusCode}`);
    }
  });

  req.on("error", (error) => {
    console.error(`Requête ${i} Erreur :`, error.message);
  });

  req.write(data);
  req.end();
}
