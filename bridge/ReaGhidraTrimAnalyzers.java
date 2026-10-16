// REA 的 Ghidra 分析器裁剪脚本（由 dsh-rea 插件投放到 REA 的 bridge/ghidra/ 下）。
//
// 为什么存在：Ghidra 的默认分析器集合里，Stack 与 Basic Constant Reference Analyzer
// 在大型/混淆二进制上会吃掉总分析时间的 60% 以上（实测 6.9 MB 的 .so：305 s → 121 s）。
// 这两个都是「让伪代码更好读」的增强项，不是产出结论的必需品。
//
// 由 REA 以 -preScript 方式在「导入之后、自动分析之前」调用，参数即要关掉的
// analyzer 名（可多个）。开关写进 program 的 ANALYSIS_PROPERTIES，AutoAnalysisManager
// 在分析时读它。
import ghidra.app.script.GhidraScript;
import ghidra.framework.options.Options;
import ghidra.program.model.listing.Program;

public class ReaGhidraTrimAnalyzers extends GhidraScript {
    @Override
    public void run() throws Exception {
        Options opts = currentProgram.getOptions(Program.ANALYSIS_PROPERTIES);
        for (String name : getScriptArgs()) {
            opts.setBoolean(name, false);
            println("REA analyzer trim: \"" + name + "\" -> false");
        }
    }
}
