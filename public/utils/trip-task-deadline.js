/** Presentation only: never use the projected date as an editor's saved value. */
export function tripTaskDeadline(task){
 return task?.trip_group?{...task,due_date:task.display_due_date,due_time:task.display_due_time}:task;
}
