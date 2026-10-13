<script lang="ts">
  import DiffPanel from '../../src/DiffPanel.svelte';
  import type { WorkingDiffInfo } from '../../src/lib/diff';
  import type { DiffComment } from '../../src/lib/diff-comments';

  const patch = [
    '@@ -0,0 +1,2000 @@',
    ...Array.from({ length: 2000 }, (_, index) => `+Line ${index + 1}`),
  ].join('\n');
  const files: WorkingDiffInfo[] = [
    {
      file: 'large.txt',
      patch,
      stagedPatch: '',
      unstagedPatch: patch,
      untracked: false,
      status: 'modified',
      additions: 2000,
      deletions: 0,
    },
  ];
  let comments = $state<DiffComment[]>([]);
</script>

<main>
  <DiffPanel
    {files}
    directory="/fixture"
    annotations={{}}
    selected="large.txt"
    loading={false}
    error=""
    onselect={() => {}}
    onrefresh={() => {}}
    onclose={() => {}}
    {comments}
    scope="fixture"
    oncomments={(_, next) => (comments = next)}
    oncommentssent={() => {}}
    onsendcomments={async () => {}}
  />
</main>

<style>
  main {
    height: 100vh;
  }
</style>
