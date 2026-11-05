<script>
  let { data } = $props();
  let time = $state("");

  async function ask() {
    const r = await fetch("/api/time");
    time = (await r.json()).time;
  }
</script>

<svelte:head><title>SvelteKit in a browser VM</title></svelte:head>

<main>
  <h1>Hello from SvelteKit</h1>
  <p>This page was rendered on the server at <code>{data.renderedAt}</code>, by Node {data.node} on {data.machine}: a Linux VM in your browser tab.</p>
  <button onclick={ask}>ask the server for the time</button>
  {#if time}<p>The server says it's <code>{time}</code>.</p>{/if}
  <p class="hint">Edit <code>src/routes/+page.svelte</code> and save: the page updates without reloading.</p>
</main>

<style>
  main { font-family: system-ui, sans-serif; max-width: 38rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }
  .hint { color: #666; }
</style>
