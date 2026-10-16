// База знаний (модуль note, только REST v3) — замер на тестовом облачном портале 2026-10-16.
export default defineMcpTool({
  name: 'note_bases',
  description: 'Список баз знаний, доступных сотруднику: id, название, уровень доступа.',
  annotations: READ_ONLY,
  inputSchema: {},
  handler: async () => {
    const { result } = await b24Call('note_bases', 'note.collection.list', { pagination: { limit: 200 } })
    return (result?.items ?? []).map((c: any) => ({ id: c.id, name: c.name, policyLevel: c.policyLevel, updatedAt: c.updatedAt }))
  },
})
