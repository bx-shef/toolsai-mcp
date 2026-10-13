export default defineMcpTool({
  name: 'user_current',
  description: 'Кто подключён: сотрудник Битрикс24, от имени которого работают все инструменты (его права).',
  annotations: READ_ONLY,
  handler: async () => {
    const u = await b24Call('user_current', 'user.current', {})
    return { id: u.ID, name: u.NAME, lastName: u.LAST_NAME, email: u.EMAIL, position: u.WORK_POSITION, departments: u.UF_DEPARTMENT }
  },
})
