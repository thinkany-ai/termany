# Bot Skill 开发安排

> 历史记录：此文描述 bots.2 及之前的实现。当前行为以 `bot-skills-optimization-execution-plan.md` 和 `bot-skills-optimization-validation.md` 为准。
实施状态：已完成 Bot 配置、Skill 快照和导入、上下文注入及界面接入；完成测试、Web 构建与服务端资源打包。PTY 自动继承仍按方案留作后续能力。

方案：[实现方案](bot-skills-implementation-plan.md)。用户已确认，按本地快照保存完整包，每轮只默认注入入口正文，参考资料由 Agent 按需读取。负责人为主线 Agent。

## 地基与契约

共享类型先落在 `packages/core/src/bot.ts`，Bot 字段沿用 `agentDescription`，新增 `agentInstructions`、`agentSkills`。创建动作接受第三个 behavior 参数，一次写入完整配置。

后端 Skill 仓库导出异步函数 `listSkills(): Promise<SkillRecord[]>`、`readSkill(skillId, revision): Promise<SkillDetail>`、`readSkillResource(skillId, revision, relativePath): Promise<string>`。所有文件解析校验在仓库内完成。编译器由主线实现，返回 `BotContextPreview`。

HTTP 契约：GET `/api/skills` 返回 `{ skills }`；POST `/api/skills/import` 接收 `SkillImportRequest`，返回 `SkillImportJob`；GET `/api/skills/imports/:id` 返回任务；DELETE 同路径取消任务；GET `/api/skills/:id/revisions/:revision` 返回 `SkillDetail`；DELETE 同路径删除未绑定版本；POST `/api/bot-context/preview` 接收 `{ botIdentity, mode: "local" | "text" }`，返回 `BotContextPreview`。所有错误返回 `{ error, code }`。多入口时任务返回 candidates，用户选择后用相同 request 加 entry 重新导入。

## 工作分配与依赖

| 执行方 | 可改范围 | 禁止范围 | 验收 |
|---|---|---|---|
| 后端任务 | 新增 `skills*.ts`、`skill*.test.ts` | 共享类型、现有 index、UI、上下文编译器 | 本地及 GitHub 导入、任务、版本、资源、HTTP 单测 |
| UI 任务 | `AgentWorkspace.tsx`、新增 Bot 表单组件及专属 CSS、文案与 UI 测试 | store、AgentPane、后端、共享类型 | 创建及编辑、导入绑定排序、预览、清空、冲突反馈 |
| 主线 | 类型、store、botContext、运行链路、AgentPane、请求映射及集成测试 | 不修改并行任务正在维护的文件 | 所有对话路径传正确配置，构建与回归通过 |

地基完成后后端与 UI 并行，主线完成上下文编译及对话链路。各任务自测后请求独立 Review Agent 审查；并发槽不足时由主线安排 reviewer，作者修复并复审至无阻塞问题。

## 派发提示词

后端：阅读实现方案与共享类型，按上方仓库和 HTTP 契约实现完整包快照、大小和路径约束、不可变版本、本地与 GitHub 导入、取消与重启任务处理、引用检查删除。只改后端新增文件，HTTP 路由封装独立模块由主线接入。为关键正常与错误路径编写隔离临时目录测试。完成自测后调用独立 review，修复复审并汇报。

UI：阅读实现方案与共享类型，新增可复用 Bot 行为表单并接入创建与编辑。支持简介、可选补充指令、Skill 搜索、多选排序、目录和 GitHub 导入、版本选择、正文及参考文件、预览校验和明确保存。按照上述 API 对接，不改 store、AgentPane 或共享类型。新文案至少中英文，其他语言回退英文。完成自测后调用独立 review，修复复审并汇报。

## 集成验收

使用临时 Skill fixture 验证两 Bot 共用引擎时正文独立、问候和群聊/A2A 映射正确、命令透传、配置清空、资源按需读取及持久化。运行 server/web 测试、web 构建、server 打包。真实远端或付费模型测试仅在现有可用配置足够时进行，未执行的实测如实记录。最终独立审查覆盖导入边界与并发、运行链路、前端状态处理。

## 实施记录

### Skill 仓库边界与删除策略

Skill 文件保存在服务端 `~/.termany/skills/<skill-id>/<revision>/`，注册表和导入任务状态通过 SQLite `app_meta` 保存。导入模块本身不加载用户数据库；默认仓库首次使用时才初始化。测试可注入临时根目录、元数据存储与 HTTP fetch，避免修改真实用户状态。

本地导入允许顶层目录软链接，解析后保存完整快照；拒绝包外软链接、循环目录与非普通文件。读取入口和参考资源时校验注册清单、文件大小和 SHA-256，参考内容还必须是合法 UTF-8 文本。`SKILL.md` 移除 YAML frontmatter 后的完整正文用于上下文编译，其他资源按需读取。

GitHub 导入限定公共 HTTPS 仓库，通过 GitHub API 解析提交与下载文件，不执行脚本、hook 或子模块。远程软链接不支持。默认限制为整个导入来源最多 20 MiB、1000 个文件和每任务 120 秒；`.git`、`node_modules` 等目录被忽略。大型仓库应填写 `source.subdirectory`，本地导入应直接选择对应 Skill 目录。`entry` 在收集文件后选择入口，不会提前缩小扫描或下载范围。公共 GitHub API 的匿名请求额度及网络中断可能使任务失败，界面会保留错误以便重试。

导入任务串行发布，避免同时导入同源同内容产生多个 Skill 身份；取消会中止当前下载或使排队任务跳过执行。服务重启后，将此前未完成任务标为中断。失败或取消的任务不会在注册表中发布可绑定的半成品。

删除版本前检查持久化 Bot 绑定；被引用版本返回 `SKILL_IN_USE`。删除成功后只移除注册表条目，磁盘快照暂时保留，避免打断已开始的 CLI 执行；新请求不能再按该版本 ID 读取。当前未实现磁盘垃圾回收，失败发布后的孤立快照也可能保留。

后端 8 组测试覆盖版本与重复导入、并发幂等、候选入口、取消及重启恢复、文件与包边界、损坏检测、GitHub 模拟响应和 HTTP 接口。相关 TypeScript 检查通过；独立审查发现的并发幂等问题已修复并复审通过。

### 真实 GitHub 仓库验收

2026-09-27，通过隔离测试服务 `http://localhost:5186` 的正式导入、详情和上下文预览接口验收。该服务的 home 已改为临时目录，没有修改真实用户 `~/.termany`，没有调用付费模型。

| 仓库 | 解析提交 | 完整包文件数 | 入口正文 | 参考文本 |
|---|---|---:|---:|---|
| `alchaincyf/elon-musk-skill` | `b5dad76f9da33c433abd80feb794625b2309e867` | 11 | 28250 字节 | 4 份，分别显式附加均成功 |
| `alchaincyf/steve-jobs-skill` | `8ae40e10013d5218f85bc0e0241fd804f3b5c5e9` | 14 | 27393 字节 | 7 份，分别显式附加均成功 |

两个仓库均保留入口、references、examples、图片及许可证。两种预览模式都包含完整入口正文；本地模式提供快照目录，文本模式不暴露本地目录并说明资源能力限制。默认预览未展开全部参考资料。将两包的 `assets/hero.gif` 作为文本附加均返回 `NOT_TEXT`；一次附加乔布斯全部参考资料返回 `BOT_CONTEXT_TOO_LARGE`，没有静默截断。

乔布斯仓库首次下载遇到流中断，任务正确记录 `IMPORT_FAILED: terminated`；重试导入成功。该结果验证了真实网络下的错误保留和重试路径，不代表网络请求不会失败。
