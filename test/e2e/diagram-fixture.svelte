<script lang="ts">
  import Diagram from '../../src/Diagram.svelte';

  const source = `flowchart TD
    input["Release inputs"] --> versions["versions.yml + active-branches.json"]
    versions --> release["team-mesh-tools release-manifest workflow"]
    versions --> backport["backport / _get-active-branches workflows: see generated output"]`;
</script>

<main>
  <Diagram {source} dark={false} title="Long-label plan" />
</main>

<style>
  main {
    width: 480px;
    padding: 20px;
  }
</style>
