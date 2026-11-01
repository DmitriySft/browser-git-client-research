const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("#app element not found");

app.innerHTML = `<h1>Hello, world!</h1>`;
console.log("Browser Git Client started");
