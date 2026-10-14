async function installWithRollback(actions) {
  let child;
  try {
    await actions.install();
    child = await actions.launch();
    if (!(await actions.healthy(child)))
      throw new Error("新版本未通过启动检查");
    return { status: "updated" };
  } catch (error) {
    if (child) await actions.stop(child);
    await actions.rollback();
    await actions.launchPrevious();
    return { status: "rolled-back", reason: error.message };
  }
}
module.exports = { installWithRollback };
