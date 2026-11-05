<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
</script>

<main>
  <h1>Hello from Svelte</h1>
  <p>This page is served by Vite, running in a Linux VM in your browser tab.</p>
  <button onclick={() => count++}>clicked {count} {count === 1 ? "time" : "times"}</button>
  <p>doubled: {doubled}</p>
  <p class="hint">Edit <code>src/App.svelte</code> and save: the page updates without reloading.</p>
</main>

<style>
  main { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  button { font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; }
  .hint { color: #666; }
</style>
